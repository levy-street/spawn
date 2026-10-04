import { describe, expect, test } from "bun:test";
import {
  columnTemplate,
  DEFAULT_COLUMN_WIDTHS,
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
