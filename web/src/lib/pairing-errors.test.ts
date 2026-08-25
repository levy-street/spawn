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
    ] as const) {
      expect(pairingFailureMessage(new ApiError(409, code, code))).toBe(PAIRING_FAILURE_COPY[code]);
    }
  });

  test("never leaks the server's raw expired-code string", () => {
    const error = new ApiError(400, "http_400", "user code is expired");
    expect(pairingFailureCode(error)).toBe("expired");
    expect(pairingFailureMessage(error)).toBe(
      "That code expired. On the machine, run spawnd possess again.",
    );
  });

  test("recognizes nested FastAPI detail shapes", () => {
    expect(
      pairingFailureCode(new ApiError(409, "http_409", "Conflict", { error: "key_conflict" })),
    ).toBe("key_conflict");
  });

  test("leaves unrelated network and validation errors alone", () => {
    expect(pairingFailureMessage(new ApiError(503, "http_503", "Try again later"))).toBeNull();
  });
});
