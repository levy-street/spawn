import { describe, expect, test } from "bun:test";

import { describeRtcIceFailure, newRtcBindingNonce } from "./useSessionSocket";

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

describe("describeRtcIceFailure", () => {
  test("separates relay gathering failure from relay connection failure", () => {
    expect(describeRtcIceFailure(false)).toContain("no relay candidate was gathered");
    expect(describeRtcIceFailure(true)).toContain("relay candidates were gathered");
    expect(describeRtcIceFailure(true)).toContain("no candidate pair connected");
  });
});
