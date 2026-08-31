import { describe, expect, test } from "bun:test";
import { DEFAULT_NEXT, safeNext, withNext } from "./safe-next";

describe("safeNext", () => {
  test("keeps a same-origin absolute path", () => {
    expect(safeNext("/device?ref=abc")).toBe("/device?ref=abc");
  });

  test("refuses anything that could leave the origin", () => {
    for (const hostile of [
      "//evil.test/steal",
      "https://evil.test",
      "http://evil.test",
      "javascript:alert(1)",
      "device?ref=abc",
      "",
      null,
    ]) {
      expect(safeNext(hostile)).toBe(DEFAULT_NEXT);
    }
  });

  test("drops the fragment, because the host key must never ride a redirect", () => {
    expect(safeNext("/device?ref=abc#k=secret")).toBe("/device?ref=abc");
    expect(safeNext("/device?ref=abc#k=secret")).not.toContain("secret");
  });

  test("an explicit fallback replaces the default", () => {
    expect(safeNext(null, "/onboarding")).toBe("/onboarding");
    expect(safeNext("//evil.test", "/onboarding")).toBe("/onboarding");
  });
});

describe("withNext", () => {
  test("carries a real destination between auth screens", () => {
    expect(withNext("/signup", "/device?ref=abc")).toBe("/signup?next=%2Fdevice%3Fref%3Dabc");
  });

  test("adds nothing when there is nowhere particular to go", () => {
    expect(withNext("/signup", null)).toBe("/signup");
    expect(withNext("/signup", "//evil.test")).toBe("/signup");
  });
});
