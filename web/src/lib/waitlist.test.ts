import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";
import { joinFailureMessage, looksLikeEmail, WAITLIST } from "./waitlist";

describe("joinFailureMessage", () => {
  test("a rate limit is named as such", () => {
    expect(joinFailureMessage(new ApiError(429, "http_429", "too many requests"))).toBe(
      WAITLIST.tooMany,
    );
  });

  test("anything else is the generic line", () => {
    expect(joinFailureMessage(new ApiError(500, "http_500", "boom"))).toBe(WAITLIST.failed);
    expect(joinFailureMessage(new TypeError("Failed to fetch"))).toBe(WAITLIST.failed);
    expect(joinFailureMessage(undefined)).toBe(WAITLIST.failed);
  });
});

describe("looksLikeEmail", () => {
  test("ordinary addresses pass, with surrounding space forgiven", () => {
    expect(looksLikeEmail("someone@example.com")).toBe(true);
    expect(looksLikeEmail("  first.last+tag@sub.example.co.uk ")).toBe(true);
  });

  test("obvious slips are caught before a round trip", () => {
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail("someone")).toBe(false);
    expect(looksLikeEmail("someone@")).toBe(false);
    expect(looksLikeEmail("someone@example")).toBe(false);
    expect(looksLikeEmail("some one@example.com")).toBe(false);
    expect(looksLikeEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});
