import { describe, expect, test } from "bun:test";
import { formatModified, formatSize, formatTimestamp } from "./format";

describe("sizes", () => {
  test("bytes, then binary units with one decimal under ten", () => {
    expect(formatSize(null)).toBe("");
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatSize(3 * 1024 ** 4)).toBe("3.0 TB");
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 3, 15, 30);
  const at = (date: Date) => Math.floor(date.getTime() / 1000);

  test("today and yesterday by name", () => {
    expect(formatModified(at(new Date(2026, 9, 3, 9, 5)), now, "en-GB")).toBe("Today at 9:05");
    expect(formatModified(at(new Date(2026, 9, 2, 23, 59)), now, "en-GB")).toBe(
      "Yesterday at 23:59",
    );
  });

  test("anything older by its date", () => {
    expect(formatModified(at(new Date(2025, 0, 7, 8, 0)), now, "en-GB")).toBe("7 Jan 2025 at 8:00");
  });

  test("no time is no words", () => {
    expect(formatModified(null, now)).toBe("");
    expect(formatModified(Number.NaN, now)).toBe("");
    expect(formatTimestamp(undefined)).toBe("");
  });
});
