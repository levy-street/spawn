import { describe, expect, test } from "bun:test";
import { isCompleteUserCode, normalizeUserCode } from "./user-code";

describe("normalizeUserCode", () => {
  test("leaves a canonical code alone", () => {
    expect(normalizeUserCode("QZ4K-7HMT")).toBe("QZ4K-7HMT");
  });

  test("accepts every shape a person actually types or pastes", () => {
    for (const typed of [
      "qz4k-7hmt",
      "QZ4K7HMT",
      "qz4k 7hmt",
      " QZ4K-7HMT ",
      "QZ4K–7HMT", // an en dash, courtesy of a copy through a chat client
      "QZ4K_7HMT",
      "QZ4K-7HMT\n",
    ]) {
      expect(normalizeUserCode(typed)).toBe("QZ4K-7HMT");
    }
  });

  test("formats progressively while typing, without a leading dash", () => {
    expect(normalizeUserCode("q")).toBe("Q");
    expect(normalizeUserCode("qz4k")).toBe("QZ4K");
    expect(normalizeUserCode("qz4k7")).toBe("QZ4K-7");
  });

  test("drops characters the alphabet never mints", () => {
    // No 0/O/1/I by design, so anything else is noise from a bad paste.
    expect(normalizeUserCode("QZ4K-7HMT-EXTRA")).toBe("QZ4K-7HMT");
    expect(normalizeUserCode("!!!!")).toBe("");
  });
});

describe("isCompleteUserCode", () => {
  test("only a full eight characters counts", () => {
    expect(isCompleteUserCode("QZ4K-7HMT")).toBe(true);
    expect(isCompleteUserCode("qz4k7hmt")).toBe(true);
    expect(isCompleteUserCode("QZ4K-7HM")).toBe(false);
    expect(isCompleteUserCode("")).toBe(false);
  });
});
