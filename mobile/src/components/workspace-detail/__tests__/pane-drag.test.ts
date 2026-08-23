import { type TabStripGeometry, tabIndexAtPoint } from "@/components/workspace-detail/pane-drag";

const GEOMETRY: TabStripGeometry = {
  stripLeft: 0,
  stripTop: 100,
  stripWidth: 390,
  stripHeight: 56,
  scrollX: 0,
  contentInset: 6,
  tabWidth: 144,
  tabGap: 8,
  tabCount: 3,
};

/** The centre of tab `index` in window coordinates, at rest. */
function centreOf(index: number, geometry: TabStripGeometry = GEOMETRY): number {
  return (
    geometry.stripLeft +
    geometry.contentInset -
    geometry.scrollX +
    index * (geometry.tabWidth + geometry.tabGap) +
    geometry.tabWidth / 2
  );
}

describe("dropping a carried pane on a tab", () => {
  test("names the tab under the finger", () => {
    expect(tabIndexAtPoint(centreOf(0), 120, GEOMETRY)).toBe(0);
    expect(tabIndexAtPoint(centreOf(1), 120, GEOMETRY)).toBe(1);
    expect(tabIndexAtPoint(centreOf(2), 120, GEOMETRY)).toBe(2);
  });

  test("counts the strip's scroll, so a scrolled tab is still hit where it is drawn", () => {
    const scrolled = { ...GEOMETRY, scrollX: 152 };
    expect(tabIndexAtPoint(centreOf(1, scrolled), 120, scrolled)).toBe(1);
    expect(tabIndexAtPoint(centreOf(2, scrolled), 120, scrolled)).toBe(2);
  });

  test("answers nothing above or below the strip's own band", () => {
    expect(tabIndexAtPoint(centreOf(0), 99, GEOMETRY)).toBe(-1);
    expect(tabIndexAtPoint(centreOf(0), 157, GEOMETRY)).toBe(-1);
  });

  test("gives the gap between two tabs to neither of them", () => {
    // Four points into the eight-point gap that follows the first tab.
    const inGap = GEOMETRY.contentInset + GEOMETRY.tabWidth + 4;
    expect(tabIndexAtPoint(inGap, 120, GEOMETRY)).toBe(-1);
  });

  test("refuses the run of strip past the last tab — the add button is not a target", () => {
    const pastEnd = GEOMETRY.contentInset + 3 * (GEOMETRY.tabWidth + GEOMETRY.tabGap) + 10;
    expect(tabIndexAtPoint(pastEnd, 120, GEOMETRY)).toBe(-1);
    expect(tabIndexAtPoint(-20, 120, GEOMETRY)).toBe(-1);
  });

  test("has no target at all before the strip has been measured", () => {
    expect(tabIndexAtPoint(80, 120, { ...GEOMETRY, stripWidth: 0, stripHeight: 0 })).toBe(-1);
    expect(tabIndexAtPoint(80, 120, { ...GEOMETRY, tabCount: 0 })).toBe(-1);
  });
});
