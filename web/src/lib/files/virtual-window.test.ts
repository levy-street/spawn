import { describe, expect, test } from "bun:test";
import { pageRows, revealScrollTop, virtualWindow } from "./virtual-window";

describe("the rendered slice", () => {
  test("covers the viewport plus a margin either side", () => {
    expect(
      virtualWindow({ count: 1024, rowHeight: 28, scrollTop: 2800, viewportHeight: 560 }),
    ).toEqual({ start: 92, end: 128, total: 1024 * 28 });
  });

  test("is clamped at both ends", () => {
    expect(virtualWindow({ count: 5, rowHeight: 28, scrollTop: 0, viewportHeight: 560 })).toEqual({
      start: 0,
      end: 5,
      total: 140,
    });
    const bottom = virtualWindow({
      count: 100,
      rowHeight: 20,
      scrollTop: 100_000,
      viewportHeight: 400,
    });
    expect(bottom.end).toBe(100);
  });

  test("an empty list renders nothing", () => {
    expect(virtualWindow({ count: 0, rowHeight: 28, scrollTop: 0, viewportHeight: 500 })).toEqual({
      start: 0,
      end: 0,
      total: 0,
    });
  });

  test("before layout it renders a screenful, not the whole folder", () => {
    const slice = virtualWindow({ count: 1024, rowHeight: 28, scrollTop: 0, viewportHeight: 0 });
    expect(slice.start).toBe(0);
    expect(slice.end).toBeLessThan(100);
  });
});

describe("keeping the focused row in view", () => {
  const view = { rowHeight: 20, viewportHeight: 200 };

  test("a visible row needs no scroll", () => {
    expect(revealScrollTop({ ...view, index: 3, scrollTop: 0 })).toBeNull();
  });

  test("a row above scrolls to its top, one below to its bottom", () => {
    expect(revealScrollTop({ ...view, index: 2, scrollTop: 100 })).toBe(40);
    expect(revealScrollTop({ ...view, index: 15, scrollTop: 0 })).toBe(120);
  });

  test("a page is a screenful less one row", () => {
    expect(pageRows(20, 200)).toBe(9);
    expect(pageRows(20, 10)).toBe(1);
  });
});
