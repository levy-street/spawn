import { describe, expect, test } from "bun:test";
import {
  type ColumnWidths,
  columnTemplate,
  DEFAULT_COLUMN_WIDTHS,
  type DetailsLayout,
  detailsLayout,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTHS,
  minimumTableWidth,
  parseColumnWidths,
  resizeColumn,
} from "./columns";

describe("Details columns", () => {
  test("a drag is clamped to sensible widths", () => {
    expect(resizeColumn(DEFAULT_COLUMN_WIDTHS, "size", 10).size).toBe(MIN_COLUMN_WIDTHS.size);
    expect(resizeColumn(DEFAULT_COLUMN_WIDTHS, "kind", 5_000).kind).toBe(MAX_COLUMN_WIDTH);
    expect(resizeColumn(DEFAULT_COLUMN_WIDTHS, "modified", 200.4).modified).toBe(200);
  });

  test("a drag that changes nothing is the same object", () => {
    expect(resizeColumn(DEFAULT_COLUMN_WIDTHS, "size", DEFAULT_COLUMN_WIDTHS.size)).toBe(
      DEFAULT_COLUMN_WIDTHS,
    );
  });

  test("stored widths are read column by column, defaults for the rest", () => {
    expect(parseColumnWidths({ size: 120, kind: "wide", name: -4 })).toEqual({
      ...DEFAULT_COLUMN_WIDTHS,
      size: 120,
      name: MIN_COLUMN_WIDTHS.name,
    });
    expect(parseColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  test("name takes the slack; the rest are fixed", () => {
    expect(columnTemplate(DEFAULT_COLUMN_WIDTHS)).toBe("minmax(280px, 1fr) 180px 88px 140px");
    expect(minimumTableWidth(DEFAULT_COLUMN_WIDTHS)).toBe(280 + 180 + 88 + 140);
  });
});

describe("Details at the width its panel has", () => {
  const keys = (layout: DetailsLayout) => layout.columns.map((column) => column.key);
  const all = 280 + 180 + 88 + 140;
  const withoutKind = 280 + 180 + 88;

  test("every column shows until the panel has been measured", () => {
    for (const unmeasured of [null, undefined, Number.NaN]) {
      const layout = detailsLayout(DEFAULT_COLUMN_WIDTHS, unmeasured);
      expect(keys(layout)).toEqual(["name", "modified", "size", "kind"]);
      expect(layout.stacked).toBe(false);
    }
  });

  test("a panel wide enough for them all shows them all", () => {
    expect(keys(detailsLayout(DEFAULT_COLUMN_WIDTHS, all))).toEqual([
      "name",
      "modified",
      "size",
      "kind",
    ]);
    expect(keys(detailsLayout(DEFAULT_COLUMN_WIDTHS, 1400))).toHaveLength(4);
  });

  test("Kind is the first to go", () => {
    for (const width of [all - 1, withoutKind]) {
      const layout = detailsLayout(DEFAULT_COLUMN_WIDTHS, width);
      expect(keys(layout)).toEqual(["name", "modified", "size"]);
      expect(layout.stacked).toBe(false);
      expect(columnTemplate(DEFAULT_COLUMN_WIDTHS, layout)).toBe("minmax(280px, 1fr) 180px 88px");
      expect(minimumTableWidth(DEFAULT_COLUMN_WIDTHS, layout)).toBe(withoutKind);
    }
  });

  test("narrower than Name, Date modified and Size, each row folds as the phone's does", () => {
    // A phone's width: the cockpit's Files tab at 390 px has about 370.
    for (const width of [withoutKind - 1, 370, 240, 0]) {
      const layout = detailsLayout(DEFAULT_COLUMN_WIDTHS, width);
      expect(keys(layout)).toEqual(["name"]);
      expect(layout.stacked).toBe(true);
      // One column as wide as the panel, however narrow: nothing to scroll sideways.
      expect(columnTemplate(DEFAULT_COLUMN_WIDTHS, layout)).toBe("minmax(0, 1fr)");
      expect(minimumTableWidth(DEFAULT_COLUMN_WIDTHS, layout)).toBe(0);
    }
  });

  test("the widths the person settled on decide what fits", () => {
    const narrowed: ColumnWidths = { ...DEFAULT_COLUMN_WIDTHS, modified: 96, kind: 72 };
    expect(keys(detailsLayout(narrowed, 280 + 96 + 88 + 72))).toHaveLength(4);
    const longNames: ColumnWidths = { ...DEFAULT_COLUMN_WIDTHS, name: 600 };
    expect(keys(detailsLayout(longNames, 900))).toEqual(["name", "modified", "size"]);
    expect(detailsLayout(longNames, 800).stacked).toBe(true);
  });
});
