import { describe, expect, test } from "bun:test";

import { newRtcBindingNonce } from "./useSessionSocket";

describe("newRtcBindingNonce", () => {
  test("fails closed when cryptographic randomness is unavailable", () => {
    expect(newRtcBindingNonce(null)).toBeNull();
  });

  test("fails closed when the cryptographic random source throws", () => {
    expect(
      newRtcBindingNonce(() => {
        throw new Error("random source unavailable");
      }),
    ).toBeNull();
  });

  test("encodes exactly 128 cryptographic random bits as lowercase hex", () => {
    const nonce = newRtcBindingNonce((bytes) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    });

    expect(nonce).toBe("000102030405060708090a0b0c0d0e0f");
  });
});
