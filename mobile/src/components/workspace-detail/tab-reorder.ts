export interface TabDragGeometry {
  tabWidth: number;
  tabGap: number;
}

function clampIndex(index: number, count: number): number {
  "worklet";
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
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
  const step = geometry.tabWidth + geometry.tabGap;
  const draggedLeft = from * step + translationX;
  const draggedRight = draggedLeft + geometry.tabWidth;
  let destination = from;

  if (translationX > 0) {
    for (let index = from + 1; index < tabCount; index += 1) {
      const neighborMidpoint = index * step + geometry.tabWidth / 2;
      if (draggedRight <= neighborMidpoint) break;
      destination = index;
    }
  } else if (translationX < 0) {
    for (let index = from - 1; index >= 0; index -= 1) {
      const neighborMidpoint = index * step + geometry.tabWidth / 2;
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
  const step = geometry.tabWidth + geometry.tabGap;
  if (toIndex < fromIndex) {
    return Math.max(0, toIndex * step - geometry.tabGap / 2);
  }
  if (toIndex > fromIndex) {
    return toIndex * step + geometry.tabWidth + geometry.tabGap / 2;
  }
  return fromIndex * step;
}
