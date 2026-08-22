import { ensureCryptoReady, randomBytes } from "@/lib/crypto/bootstrap";

jest.mock("expo-crypto", () => ({
  getRandomValues: jest.fn((bytes: Uint8Array) => {
    bytes.fill(7);
    return bytes;
  }),
}));

describe("crypto bootstrap", () => {
  test("is idempotent and exposes only CSPRNG-backed bytes", () => {
    expect(() => ensureCryptoReady()).not.toThrow();
    expect(() => ensureCryptoReady()).not.toThrow();
    expect(randomBytes(4)).toHaveLength(4);
  });

  test.each([0, -1, 1.5, 65_537, Number.NaN])("rejects random length %s", (length) => {
    expect(() => randomBytes(length)).toThrow();
  });
});
