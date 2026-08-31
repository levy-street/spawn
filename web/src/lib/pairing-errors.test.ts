import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";
import { PAIRING_FAILURE_COPY, pairingFailureCode, pairingFailureMessage } from "./pairing-errors";

describe("pairing error catalogue", () => {
  test("maps every terminal wire error to the exact shared copy", () => {
    for (const code of [
      "expired",
      "denied",
      "key_conflict",
      "pin_conflict",
      "pin_limit",
      "host_limit",
    ] as const) {
      expect(pairingFailureMessage(new ApiError(409, code, code))).toBe(PAIRING_FAILURE_COPY[code]);
    }
  });

  test("never leaks the server's raw legacy expiry string", () => {
    const error = new ApiError(400, "http_400", "user code is expired");
    expect(pairingFailureCode(error)).toBe("expired");
    expect(pairingFailureMessage(error)).toBe(
      "That approval expired. On the machine, run spawnd possess again.",
    );
  });

  test("recognizes nested FastAPI detail shapes", () => {
    expect(
      pairingFailureCode(new ApiError(409, "http_409", "Conflict", { error: "key_conflict" })),
    ).toBe("key_conflict");
  });

  test("reads host_limit out of the 402's structured body", () => {
    // What `billing.limit_error_detail` sends: a machine code and three
    // numbers, arriving as FastAPI's `detail` object rather than a string.
    const error = new ApiError(402, "http_402", "Payment Required", {
      code: "host_limit",
      tier: "coven",
      host_limit: 3,
      host_count: 3,
    });
    expect(pairingFailureCode(error)).toBe("host_limit");
    expect(pairingFailureMessage(error)).toBe(PAIRING_FAILURE_COPY.host_limit);
  });

  test("reads host_limit out of the daemon poll's bare error shape", () => {
    expect(
      pairingFailureCode(new ApiError(400, "http_400", "Bad Request", { error: "host_limit" })),
    ).toBe("host_limit");
  });

  test("never confuses the two codes ending in limit", () => {
    // Both contain "limit", and the catalogue matches on substrings — so the
    // needle has to be the whole code. A browser cap must never read as a
    // plan cap, or a person would be sold a subscription to fix the wrong
    // problem.
    expect(pairingFailureCode(new ApiError(409, "http_409", "refused: host_limit"))).toBe(
      "host_limit",
    );
    expect(pairingFailureCode(new ApiError(409, "http_409", "refused: pin_limit"))).toBe(
      "pin_limit",
    );
    // A bare "limit" is neither, and guessing would be worse than silence.
    expect(pairingFailureCode(new ApiError(409, "http_409", "over the limit"))).toBeNull();
  });

  test("leaves unrelated network and validation errors alone", () => {
    expect(pairingFailureMessage(new ApiError(503, "http_503", "Try again later"))).toBeNull();
  });
});
