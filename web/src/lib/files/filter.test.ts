import { describe, expect, test } from "bun:test";
import { filterEntries, isHiddenName, matchName, nameMatches } from "./filter";

const entries = [
  { name: ".env" },
  { name: "README.md" },
  { name: "readme-old.txt" },
  { name: "src" },
  { name: ".git" },
];

describe("hidden files", () => {
  test("a dot-name is hidden", () => {
    expect(isHiddenName(".env")).toBe(true);
    expect(isHiddenName("env")).toBe(false);
    expect(isHiddenName("a.b")).toBe(false);
  });

  test("are left out by default and counted", () => {
    const { visible, hiddenCount } = filterEntries(entries, {});
    expect(visible.map((entry) => entry.name)).toEqual(["README.md", "readme-old.txt", "src"]);
    expect(hiddenCount).toBe(2);
  });

  test("show when asked", () => {
    const { visible, hiddenCount } = filterEntries(entries, { showHidden: true });
    expect(visible).toHaveLength(5);
    expect(hiddenCount).toBe(0);
  });
});

describe("filter as you type", () => {
  test("matches anywhere in the name, ignoring case and stray spaces", () => {
    const { visible } = filterEntries(entries, { query: " ReadMe " });
    expect(visible.map((entry) => entry.name)).toEqual(["README.md", "readme-old.txt"]);
  });

  test("a hidden match stays hidden until hidden files show", () => {
    expect(filterEntries(entries, { query: "env" }).visible).toEqual([]);
    expect(filterEntries(entries, { query: "env", showHidden: true }).visible).toEqual([
      { name: ".env" },
    ]);
  });

  test("only the hidden names the filter would show are counted as kept back", () => {
    // ".env" matches and is held back; ".git" does not match, so it is not
    // "hidden" from this filter at all — the phone counts the same way.
    expect(filterEntries(entries, { query: "env" }).hiddenCount).toBe(1);
    expect(filterEntries(entries, { query: "readme" }).hiddenCount).toBe(0);
    expect(filterEntries(entries, { query: "readme" }).visible).toHaveLength(2);
  });

  test("an empty filter matches everything", () => {
    expect(nameMatches("anything", "")).toBe(true);
    expect(nameMatches("anything", "   ")).toBe(true);
  });

  test("says where the match is, for highlighting", () => {
    expect(matchName("README.md", "me.m")).toEqual([4, 8]);
    expect(matchName("README.md", "zzz")).toBeNull();
    expect(matchName("README.md", "")).toBeNull();
  });

  test("a name whose case-folding changes its length still matches, unranged", () => {
    expect(matchName("İstanbul", "stan")).toBe("unranged");
  });
});
