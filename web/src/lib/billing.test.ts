import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";
import {
  atCapacity,
  hostLimitFacts,
  hostLimitLabel,
  hostLimitOverrideLabel,
  hostSelectionRequired,
  hostsUsedLabel,
  overBy,
  periodNotice,
  planDirection,
  priceLabel,
  serverMessage,
  subscriptionRequired,
} from "./billing";

const TIERS = [
  { key: "free", name: "Free", price_cents: 0, host_limit: 1 },
  { key: "coven", name: "Coven", price_cents: 500, host_limit: 3 },
  { key: "legion", name: "the Legion plan", price_cents: 2000, host_limit: 20 },
  { key: "pandemonium", name: "Pandemonium", price_cents: 5000, host_limit: null },
];

describe("host counts", () => {
  test("says the limit in words rather than showing a null", () => {
    expect(hostLimitLabel(3)).toBe("3");
    expect(hostLimitLabel(null)).toBe("unlimited");
  });

  test("counts against a ceiling only when there is one", () => {
    expect(hostsUsedLabel({ host_count: 3, host_limit: 3 })).toBe("3 of 3 hosts");
    expect(hostsUsedLabel({ host_count: 1, host_limit: 3 })).toBe("1 of 3 hosts");
    expect(hostsUsedLabel({ host_count: 7, host_limit: null })).toBe("7 hosts");
    expect(hostsUsedLabel({ host_count: 1, host_limit: null })).toBe("1 host");
    expect(hostsUsedLabel({ host_count: 1, host_limit: 1 })).toBe("1 of 1 host");
  });

  test("capacity is a ceiling, and unlimited never reaches one", () => {
    expect(atCapacity({ host_count: 2, host_limit: 3 })).toBe(false);
    expect(atCapacity({ host_count: 3, host_limit: 3 })).toBe(true);
    // Over the limit is still at it: the next host is refused either way.
    expect(atCapacity({ host_count: 9, host_limit: 3 })).toBe(true);
    expect(atCapacity({ host_count: 999, host_limit: null })).toBe(false);
  });

  test("counts how many must go, and never a negative number", () => {
    expect(overBy({ host_count: 9, host_limit: 3 })).toBe(6);
    expect(overBy({ host_count: 2, host_limit: 3 })).toBe(0);
    expect(overBy({ host_count: 9, host_limit: null })).toBe(0);
  });
});

describe("prices", () => {
  test("renders whole dollars without decimals and cents with them", () => {
    expect(priceLabel(500)).toBe("$5/mo");
    expect(priceLabel(2000)).toBe("$20/mo");
    expect(priceLabel(1250)).toBe("$12.50/mo");
  });

  test("a free tier is named, not priced at zero", () => {
    expect(priceLabel(0)).toBe("Free");
  });
});

describe("the period notice", () => {
  test("distinguishes a renewal from a cancellation that has not landed yet", () => {
    expect(
      periodNotice({ current_period_end: "2026-09-30T00:00:00Z", cancel_at_period_end: false }),
    ).toEqual({ tone: "renews", at: "2026-09-30T00:00:00Z" });
    expect(
      periodNotice({ current_period_end: "2026-09-30T00:00:00Z", cancel_at_period_end: true }),
    ).toEqual({ tone: "ends", at: "2026-09-30T00:00:00Z" });
  });

  test("says nothing at all when there is no subscription period", () => {
    expect(periodNotice({ current_period_end: null, cancel_at_period_end: false })).toBeNull();
  });
});

describe("plan direction", () => {
  test("reads by price, in both directions", () => {
    expect(planDirection("free", "coven", TIERS)).toBe("upgrade");
    expect(planDirection("legion", "coven", TIERS)).toBe("downgrade");
    expect(planDirection("coven", "coven", TIERS)).toBe("same");
  });

  test("an unknown tier is neutral rather than a guess", () => {
    expect(planDirection("free", "mystery", TIERS)).toBe("same");
    expect(planDirection("mystery", "free", TIERS)).toBe("same");
  });
});

describe("the comp override", () => {
  test("never shows the raw number, because 0 means the opposite of nothing", () => {
    expect(hostLimitOverrideLabel(null)).toBe("No override");
    expect(hostLimitOverrideLabel(0)).toBe("Unlimited");
    expect(hostLimitOverrideLabel(1)).toBe("1 host");
    expect(hostLimitOverrideLabel(25)).toBe("25 hosts");
  });
});

describe("the structured refusals", () => {
  test("reads the 402 the ceremony is refused with", () => {
    const error = new ApiError(402, "http_402", "Payment Required", {
      code: "host_limit",
      tier: "coven",
      host_limit: 3,
      host_count: 3,
    });
    expect(hostLimitFacts(error)).toEqual({ tier: "coven", host_limit: 3, host_count: 3 });
    // The two refusals are different questions and must never be confused.
    expect(hostSelectionRequired(error)).toBeNull();
  });

  test("reads the 409 that asks which hosts to keep", () => {
    const error = new ApiError(409, "http_409", "Conflict", {
      code: "host_selection_required",
      tier: "free",
      host_limit: 1,
      host_count: 4,
    });
    expect(hostSelectionRequired(error)).toEqual({ tier: "free", host_limit: 1, host_count: 4 });
    expect(hostLimitFacts(error)).toBeNull();
  });

  test("an unlimited target arrives as a null limit, not a missing one", () => {
    const error = new ApiError(409, "http_409", "Conflict", {
      code: "host_selection_required",
      tier: "pandemonium",
      host_limit: null,
      host_count: 4,
    });
    expect(hostSelectionRequired(error)?.host_limit).toBeNull();
  });

  test("reads the 409 that means there is nothing to move", () => {
    const error = new ApiError(409, "http_409", "Conflict", { code: "subscription_required" });
    expect(subscriptionRequired(error)).toBe(true);
    expect(hostSelectionRequired(error)).toBeNull();
    expect(subscriptionRequired(new ApiError(409, "http_409", "Conflict"))).toBe(false);
  });

  test("shows the server's prose and never its status text", () => {
    expect(
      serverMessage(new ApiError(503, "http_503", "Try again", "Billing is unavailable")),
    ).toBe("Billing is unavailable");
    expect(
      serverMessage(new ApiError(400, "http_400", "Bad Request", { message: "Unknown tier" })),
    ).toBe("Unknown tier");
    // A machine code only: the caller has a real sentence, "Conflict" is not it.
    expect(serverMessage(new ApiError(409, "http_409", "Conflict", { code: "nope" }))).toBeNull();
    expect(serverMessage(new ApiError(500, "http_500", "Internal Server Error"))).toBeNull();
    expect(serverMessage(new Error("boom"))).toBeNull();
  });

  test("leaves every other error alone", () => {
    expect(hostLimitFacts(new ApiError(503, "http_503", "Try again later"))).toBeNull();
    expect(hostLimitFacts(new ApiError(409, "http_409", "Conflict", "a string detail"))).toBeNull();
    expect(hostLimitFacts(new Error("host_limit"))).toBeNull();
    expect(hostSelectionRequired(null)).toBeNull();
  });
});
