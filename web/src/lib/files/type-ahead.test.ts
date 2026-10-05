import { describe, expect, test } from "bun:test";
import { pushTypeAhead, TYPE_AHEAD_RESET_MS, typeAheadMatch } from "./type-ahead";

const names = ["docs", "README.md", "scripts", "server", "src", "web"];

describe("the typed prefix", () => {
  test("letters typed close together build one prefix", () => {
    let state = pushTypeAhead(null, "s", 0);
    state = pushTypeAhead(state, "e", 300);
    expect(state.buffer).toBe("se");
  });

  test("a pause starts over", () => {
    let state = pushTypeAhead(null, "s", 0);
    state = pushTypeAhead(state, "w", TYPE_AHEAD_RESET_MS + 1);
    expect(state.buffer).toBe("w");
  });
});

describe("where it lands", () => {
  test("a prefix finds the first name starting with it, ignoring case", () => {
    expect(typeAheadMatch(names, "re", -1)).toBe(1);
    expect(typeAheadMatch(names, "se", -1)).toBe(3);
  });

  test("one letter steps past the focused row, wrapping at the end", () => {
    expect(typeAheadMatch(names, "s", 2)).toBe(3);
    expect(typeAheadMatch(names, "s", 4)).toBe(2);
    expect(typeAheadMatch(names, "w", 5)).toBe(5);
  });

  test("a longer prefix keeps the row it already found", () => {
    expect(typeAheadMatch(names, "sc", 2)).toBe(2);
  });

  test("the same letter again walks through the names starting with it", () => {
    expect(typeAheadMatch(names, "ss", 2)).toBe(3);
    expect(typeAheadMatch(names, "sss", 3)).toBe(4);
  });

  test("nothing matching lands nowhere", () => {
    expect(typeAheadMatch(names, "zz", 0)).toBe(-1);
    expect(typeAheadMatch([], "a", 0)).toBe(-1);
    expect(typeAheadMatch(names, "", 0)).toBe(-1);
  });
});
